import type { PrismaClient, User } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma.js';
import { hashPassword, verifyPassword, hashToken, verifyToken } from '../../infrastructure/crypto/password.js';
import {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  generateOpaqueToken,
} from '../../infrastructure/crypto/tokens.js';
import {
  generateTotpSecret,
  verifyTotp,
  encryptSecret,
  decryptSecret,
  buildTotpQrDataUrl,
  generateBackupCodes,
} from '../../infrastructure/crypto/totp.js';
import { recordAudit, type AuditContext } from '../audit/audit-logger.js';
import { TermsService } from '../legal/terms-service.js';
import {
  InvalidCredentialsError,
  AccountLockedError,
  EmailAlreadyExistsError,
  TwoFactorRequiredError,
  InvalidTwoFactorError,
  InvalidRefreshTokenError,
} from '../../domain/errors/auth-errors.js';
import { ForbiddenError, ValidationError } from '../../domain/errors/domain-error.js';
import { getEnv } from '../../infrastructure/config/env.js';
import type {
  RegisterInput,
  LoginInput,
  ResetPasswordInput,
} from '../../shared/schemas/auth.schema.js';
import { randomUUID } from 'node:crypto';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface AuthResult {
  user: {
    id: string; email: string; name: string; role: string; mustChangePassword: boolean;
    /** true = tiene que aceptar los Términos y Condiciones antes de seguir. */
    needsTermsAcceptance: boolean;
  };
  tokens: TokenPair;
}

export class AuthService {
  constructor(
    private readonly db: PrismaClient = prisma,
    private readonly terms: TermsService = new TermsService(db),
  ) {}

  async emailExists(email: string): Promise<boolean> {
    const user = await this.db.user.findUnique({ where: { email }, select: { id: true } });
    return user !== null;
  }

  async cuitExists(cuit: string): Promise<boolean> {
    const clean = cuit.replace(/[-\s]/g, '');
    // Normalizar a formato XX-XXXXXXXX-X para buscar
    const formatted =
      clean.length === 11
        ? `${clean.slice(0, 2)}-${clean.slice(2, 10)}-${clean.slice(10)}`
        : cuit;
    const user = await this.db.user.findFirst({
      where: { cuit: { in: [cuit, clean, formatted] } },
      select: { id: true },
    });
    return user !== null;
  }

  // -- Registro -----------------------------------------------------------

  async register(input: RegisterInput, ctx: AuditContext): Promise<AuthResult> {
    const existing = await this.db.user.findUnique({ where: { email: input.email } });
    if (existing) {
      // No revelar existencia: log interno, error neutro.
      await recordAudit({ ...ctx, action: 'auth.register.duplicate_email', newValue: { email: input.email } }, this.db);
      throw new EmailAlreadyExistsError();
    }

    // La versión que el frontend le mostró tiene que ser la vigente AHORA —
    // no confiamos en el string que manda el cliente por si quedó una pestaña
    // vieja abierta con una versión de Términos ya reemplazada.
    const currentTerms = await this.terms.requireCurrentVersion();
    if (input.termsVersionId !== currentTerms.id) {
      await recordAudit({ ...ctx, action: 'auth.register.stale_terms_version' }, this.db);
      throw new ValidationError('Los Términos y Condiciones cambiaron. Recargá la página y volvé a intentar.');
    }

    const passwordHash = await hashPassword(input.password);

    // Alta completa en una transacción: usuario + preferencias + cartera
    // inicial + la ACEPTACIÓN de términos — es la firma del contrato, no
    // puede quedar un usuario creado sin su aceptación registrada.
    // El usuario aun no tiene JWT al registrarse, pero su AlertSetting si queda
    // bajo RLS. Reservar el id antes permite abrir una unica transaccion con el
    // tenant correcto, sin convertir el alta publica en una excepcion de RLS.
    const userId = randomUUID();
    const user = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      const created = await tx.user.create({
        data: {
          id: userId,
          email: input.email,
          passwordHash,
          name: input.name,
          cuit: input.cuit,
          dni: input.dni ?? null,
          professionalType: input.professionalType,
          licenseNumber: input.licenseNumber ?? null,
          province: input.province,
          onboardedAt: new Date(),
          alertSettings: { create: { marginThresholdPct: input.marginThresholdPct } },
        },
      });

      await tx.termsAcceptance.create({
        data: {
          userId: created.id,
          termsVersionId: currentTerms.id,
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });

      if (input.initialClients?.length) {
        await tx.company.createMany({
          data: input.initialClients.map((c) => ({
            userId: created.id,
            name: c.name,
            industry: c.industry ?? null,
            cuit: c.cuit ?? null,
          })),
        });
      }
      return created;
    });

    await recordAudit(
      {
        ...ctx,
        userId: user.id,
        action: 'auth.register.success',
        newValue: { initialClients: input.initialClients?.length ?? 0, termsVersion: currentTerms.version },
      },
      this.db,
    );
    const tokens = await this.issueTokens(user, ctx);
    // needsTermsAcceptance siempre false acá: la acabamos de crear arriba.
    return { user: { ...this.publicUser(user), needsTermsAcceptance: false }, tokens };
  }

  // -- Login --------------------------------------------------------------

  async login(input: LoginInput, ctx: AuditContext): Promise<AuthResult> {
    // El identificador puede ser email (operadores) o CUIT (costistas).
    const isEmail = input.identifier.includes('@');

    let user: User | null = null;

    if (isEmail) {
      user = await this.db.user.findUnique({
        where: { email: input.identifier.toLowerCase().trim() },
      });
    } else {
      // Normalizar CUIT: buscar con y sin guiones
      const cuitClean = input.identifier.replace(/[-\s]/g, '');
      const cuitFormatted =
        cuitClean.length === 11
          ? `${cuitClean.slice(0, 2)}-${cuitClean.slice(2, 10)}-${cuitClean.slice(10)}`
          : input.identifier;
      user = await this.db.user.findFirst({
        where: { cuit: { in: [input.identifier, cuitClean, cuitFormatted] } },
      });
    }

    // Comparación a tiempo constante incluso si el usuario no existe: siempre
    // ejecutamos un verify para no filtrar la existencia por timing.
    if (!user) {
      await verifyPassword(
        '$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXlzYWx0ZHVtbXk$ZHVtbXloYXNoZHVtbXloYXNoZHVtbXloYXNoZHVt',
        input.password,
      );
      await recordAudit({ ...ctx, action: 'auth.login.unknown_identifier', newValue: { identifier: input.identifier } }, this.db);
      throw new InvalidCredentialsError();
    }

    if (user.isLocked && user.lockedUntil && user.lockedUntil > new Date()) {
      await recordAudit({ ...ctx, userId: user.id, action: 'auth.login.locked' }, this.db);
      throw new AccountLockedError();
    }

    const valid = await verifyPassword(user.passwordHash, input.password);
    if (!valid) {
      await this.registerFailedAttempt(user, ctx);
      throw new InvalidCredentialsError();
    }

    // Segundo factor.
    if (user.twoFactorEnabled) {
      if (!input.twoFactorCode) {
        throw new TwoFactorRequiredError();
      }
      const ok = await this.verifyUserTwoFactor(user, input.twoFactorCode);
      if (!ok) {
        await this.registerFailedAttempt(user, ctx);
        throw new InvalidTwoFactorError();
      }
    }

    await this.resetFailedAttempts(user.id);
    await recordAudit({ ...ctx, userId: user.id, action: 'auth.login.success' }, this.db);
    const tokens = await this.issueTokens(user, ctx);
    const { needs } = await this.terms.needsAcceptance(user.id, user.role);
    return { user: { ...this.publicUser(user), needsTermsAcceptance: needs }, tokens };
  }

  // -- Refresh (rotación + invalidación de familia) -----------------------

  async refresh(rawToken: string, ctx: AuditContext): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(rawToken);
    const stored = await this.db.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.expiresAt < new Date()) {
      throw new InvalidRefreshTokenError();
    }

    // Detección de reuso: si el token ya fue rotado/revocado, es un robo de
    // sesión → invalidar TODA la familia.
    if (stored.revokedAt) {
      await this.db.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await recordAudit({ ...ctx, userId: stored.userId, action: 'auth.refresh.reuse_detected' }, this.db);
      throw new InvalidRefreshTokenError();
    }

    const user = await this.db.user.findUnique({ where: { id: stored.userId } });
    if (!user || !user.isActive) {
      throw new InvalidRefreshTokenError();
    }

    // Emitir nuevo par y marcar el anterior como reemplazado.
    const next = generateRefreshToken();
    const expiresAt = this.refreshExpiry();
    const created = await this.db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: next.hash,
        familyId: stored.familyId, // misma familia
        expiresAt,
        userAgent: ctx.userAgent ?? null,
        ipAddress: ctx.ipAddress ?? null,
      },
    });
    await this.db.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedBy: created.id },
    });

    const accessToken = signAccessToken({ sub: user.id, tenantId: user.id, role: user.role });
    return { accessToken, refreshToken: next.token, refreshExpiresAt: expiresAt };
  }

  // -- Logout -------------------------------------------------------------

  async logout(rawToken: string, ctx: AuditContext): Promise<void> {
    const tokenHash = hashRefreshToken(rawToken);
    const stored = await this.db.refreshToken.findUnique({ where: { tokenHash } });
    if (stored && !stored.revokedAt) {
      // Revocar toda la familia: cerrar sesión invalida la cadena completa.
      await this.db.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await recordAudit({ ...ctx, userId: stored.userId, action: 'auth.logout' }, this.db);
    }
  }

  // -- 2FA ----------------------------------------------------------------

  async beginTwoFactorSetup(userId: string): Promise<{ secret: string; qrDataUrl: string }> {
    const user = await this.requireUser(userId);
    const secret = generateTotpSecret();
    // Guardamos cifrado pero aún NO activamos: se activa al confirmar un código.
    await this.db.user.update({
      where: { id: userId },
      data: { twoFactorSecret: encryptSecret(secret) },
    });
    const qrDataUrl = await buildTotpQrDataUrl(secret, user.email);
    return { secret, qrDataUrl };
  }

  async confirmTwoFactor(userId: string, code: string, ctx: AuditContext): Promise<string[]> {
    const user = await this.requireUser(userId);
    if (!user.twoFactorSecret) {
      throw new InvalidTwoFactorError();
    }
    const secret = decryptSecret(user.twoFactorSecret);
    if (!verifyTotp(secret, code)) {
      throw new InvalidTwoFactorError();
    }

    const backupCodes = generateBackupCodes(10);
    const hashedBackup = await Promise.all(backupCodes.map((c) => hashToken(c)));
    await this.db.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: true, twoFactorBackupCodes: hashedBackup },
    });
    await recordAudit({ ...ctx, userId, action: 'auth.2fa.enabled' }, this.db);
    return backupCodes; // se muestran UNA vez al usuario
  }

  async disableTwoFactor(userId: string, ctx: AuditContext): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: [] },
    });
    await recordAudit({ ...ctx, userId, action: 'auth.2fa.disabled' }, this.db);
  }

  private async verifyUserTwoFactor(user: User, code: string): Promise<boolean> {
    if (user.twoFactorSecret) {
      const secret = decryptSecret(user.twoFactorSecret);
      if (verifyTotp(secret, code)) return true;
    }
    // Fallback: backup codes (un solo uso).
    for (const hash of user.twoFactorBackupCodes) {
      if (await verifyToken(hash, code.toUpperCase())) {
        await this.db.user.update({
          where: { id: user.id },
          data: { twoFactorBackupCodes: user.twoFactorBackupCodes.filter((h) => h !== hash) },
        });
        return true;
      }
    }
    return false;
  }

  // -- Reset de password --------------------------------------------------

  /** Devuelve el token en claro SOLO para que el caller lo envíe por email. */
  async createPasswordReset(email: string): Promise<string | null> {
    const user = await this.db.user.findUnique({ where: { email } });
    if (!user) return null; // no revelar existencia

    const { token, hash } = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
    await this.db.passwordReset.create({
      data: { userId: user.id, tokenHash: hash, expiresAt },
    });
    return token;
  }

  async resetPassword(input: ResetPasswordInput, ctx: AuditContext): Promise<void> {
    const tokenHash = hashRefreshToken(input.token);
    const reset = await this.db.passwordReset.findUnique({ where: { tokenHash } });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw new InvalidRefreshTokenError();
    }

    const passwordHash = await hashPassword(input.password);
    await this.db.$transaction([
      this.db.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
      this.db.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      // Cerrar todas las sesiones activas tras un reset.
      this.db.refreshToken.updateMany({
        where: { userId: reset.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await recordAudit({ ...ctx, userId: reset.userId, action: 'auth.password.reset' }, this.db);
  }

  // -- Helpers ------------------------------------------------------------

  private async issueTokens(user: User, ctx: AuditContext): Promise<TokenPair> {
    const accessToken = signAccessToken({ sub: user.id, tenantId: user.id, role: user.role });
    const { token, hash } = generateRefreshToken();
    const expiresAt = this.refreshExpiry();
    await this.db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hash,
        familyId: randomUUID(),
        expiresAt,
        userAgent: ctx.userAgent ?? null,
        ipAddress: ctx.ipAddress ?? null,
      },
    });
    return { accessToken, refreshToken: token, refreshExpiresAt: expiresAt };
  }

  private refreshExpiry(): Date {
    const days = getEnv().JWT_REFRESH_EXPIRY_DAYS;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  private async registerFailedAttempt(user: User, ctx: AuditContext): Promise<void> {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
    await this.db.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        isLocked: shouldLock,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000) : user.lockedUntil,
      },
    });
    await recordAudit(
      { ...ctx, userId: user.id, action: shouldLock ? 'auth.login.locked_out' : 'auth.login.failed' },
      this.db,
    );
  }

  private async resetFailedAttempts(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, isLocked: false, lockedUntil: null },
    });
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new InvalidCredentialsError();
    return user;
  }

  /**
   * Permite a un operador con mustChangePassword=true establecer su nueva contraseña.
   * No requiere la contraseña actual: la clave temporal ya fue verificada en el login.
   */
  async setFirstPassword(userId: string, newPassword: string, ctx: AuditContext): Promise<void> {
    const user = await this.requireUser(userId);
    if (!user.mustChangePassword) {
      throw new ForbiddenError('Esta acción solo está disponible en el primer inicio de sesión');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.db.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });
    await recordAudit({ ...ctx, userId, action: 'auth.password.first_change' }, this.db);
  }

  private publicUser(user: User) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl,
      mustChangePassword: user.mustChangePassword,
    };
  }
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const seedProfiles = readFileSync(
  fileURLToPath(new URL('../../prisma/seed-industry-profiles.ts', import.meta.url)),
  'utf8',
);
const seedAvicola = readFileSync(
  fileURLToPath(new URL('../../prisma/seed-tenant-avicola.ts', import.meta.url)),
  'utf8',
);

function unitOfAviculturaProfile(): string {
  const block = seedProfiles.match(/category:\s+'AVICULTURA',([\s\S]*?)\n\s{2}},\n\s{2}{/);
  const unit = block?.[1].match(/measurementUnit:\s+'([^']+)'/);
  if (!unit) throw new Error('El perfil AVICULTURA debe declarar una unidad de medida');
  return unit[1];
}

function businessUnitOfAvicolaSeed(): string {
  const unit = seedAvicola.match(/\{\s+codigo:\s+'([^']+)',\s+nombre:\s+'Cajón\s+de\s+huevo/);
  if (!unit) throw new Error('El seed avícola debe declarar su unidad de gestión');
  return unit[1];
}

describe('seed del perfil de industria', () => {
  it('mantiene la unidad del perfil avícola alineada con la unidad de gestión del tenant', () => {
    expect(unitOfAviculturaProfile()).toBe(businessUnitOfAvicolaSeed());
  });
});

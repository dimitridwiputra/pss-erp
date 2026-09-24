const names = {
  contracts: 'PLT-003 contracts registry and OpenAPI diff',
  db: 'PLT-002 migration ownership and destructive change checks',
  ui: 'UX-001 tokens, accessibility, and component checks',
  integration: 'PLT-004/005 integration behavior',
  e2e: 'Critical user workflows',
};
const gate = process.argv[2];
if (!gate || !(gate in names)) {
  process.stderr.write('Unknown scaffold gate.\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`${gate}: scaffold only; ${names[gate]} is scheduled after PLT-001. No feature coverage claimed.\n`);
}


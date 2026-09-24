const requiredNode = 'v24.19.0';
const requiredPnpm = '11.19.0';

export function assertToolchain(nodeVersion, userAgent) {
  if (nodeVersion !== requiredNode) {
    throw new Error(`PSS requires Node.js ${requiredNode.slice(1)}; found ${nodeVersion}. Use .nvmrc before pnpm install.`);
  }
  if (!userAgent?.startsWith(`pnpm/${requiredPnpm} `)) {
    throw new Error(`PSS requires pnpm ${requiredPnpm}; found ${userAgent ?? 'unknown package manager'}. Install the pinned pnpm version.`);
  }
}

if (process.argv[1]?.endsWith('/check-toolchain.mjs')) {
  try {
    assertToolchain(process.version, process.env.npm_config_user_agent);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}


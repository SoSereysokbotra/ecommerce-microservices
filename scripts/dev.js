const { spawn } = require('child_process');
const path = require('path');

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const rootDir = path.resolve(__dirname, '..');

// Colors for terminal output
const cyan = '\x1b[36m';
const magenta = '\x1b[35m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const reset = '\x1b[0m';

console.log(`${green}======================================================${reset}`);
console.log(`${green}🚀 Starting E-Commerce Full-Stack Development Environment${reset}`);
console.log(`${green}======================================================${reset}\n`);

// Step 1: Start Docker Compose backend stack in detached mode
console.log(`${yellow}📦 Step 1: Starting Docker Compose microservices...${reset}`);
const docker = spawn('docker', ['compose', 'up', '-d'], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: true,
});

docker.on('close', (code) => {
  if (code !== 0) {
    console.error(`❌ Docker Compose failed with exit code ${code}`);
    process.exit(code);
  }

  console.log(`\n${green}✅ Docker backend stack is up!${reset}`);
  console.log(`${cyan}🛍️  Storefront:     http://localhost:3100${reset}`);
  console.log(`${magenta}🛠️  Admin Console:  http://localhost:3200${reset}`);
  console.log(`${yellow}🌐 API Gateway:    http://localhost:3000/api/v1/docs${reset}`);
  console.log(`\n${yellow}Starting both frontends concurrently...${reset}\n`);

  function spawnService(name, color, prefix) {
    const child = spawn(npmCmd, ['--prefix', prefix, 'run', 'dev'], {
      cwd: rootDir,
      shell: true,
    });

    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          console.log(`${color}[${name}]${reset} ${line}`);
        }
      }
    });

    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          console.error(`${color}[${name}]${reset} ${line}`);
        }
      }
    });

    return child;
  }

  const storefront = spawnService('storefront', cyan, 'storefront');
  const admin = spawnService('admin     ', magenta, 'admin');

  function cleanup() {
    console.log(`\n${yellow}Shutting down frontends...${reset}`);
    storefront.kill();
    admin.kill();
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
});

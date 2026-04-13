import pc from 'picocolors';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const log = {
  info(msg: string) {
    console.log(pc.blue('ℹ'), msg);
  },

  success(msg: string) {
    console.log(pc.green('✓'), msg);
  },

  warn(msg: string) {
    console.log(pc.yellow('⚠'), msg);
  },

  error(msg: string) {
    console.error(pc.red('✗'), msg);
  },

  step(msg: string) {
    console.log(pc.cyan('→'), msg);
  },

  dim(msg: string) {
    console.log(pc.dim(`  ${msg}`));
  },

  banner(msg: string) {
    console.log();
    console.log(pc.bold(pc.cyan(`  ${msg}`)));
    console.log();
  },

  table(rows: [string, string][]) {
    const maxKey = Math.max(...rows.map(([k]) => k.length));
    for (const [key, val] of rows) {
      console.log(`  ${pc.dim(key.padEnd(maxKey))}  ${val}`);
    }
  },
};

export function spinner(text: string) {
  let i = 0;
  let current = text;
  const id = setInterval(() => {
    process.stdout.write(`\r${pc.cyan(FRAMES[i++ % FRAMES.length])} ${current}`);
  }, 80);

  return {
    update(msg: string) {
      current = msg;
    },
    success(msg?: string) {
      clearInterval(id);
      process.stdout.write(`\r${pc.green('✓')} ${msg ?? current}\n`);
    },
    fail(msg?: string) {
      clearInterval(id);
      process.stdout.write(`\r${pc.red('✗')} ${msg ?? current}\n`);
    },
    stop() {
      clearInterval(id);
      process.stdout.write('\r\x1b[K');
    },
  };
}

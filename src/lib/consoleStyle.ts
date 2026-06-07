/** ANSI styling for dev startup output; plain text when stdout is not a TTY. */

const color = process.stdout.isTTY === true;

const esc = (codes: string) => (color ? codes : '');

const R = esc('\x1b[0m');
const bold = (s: string) => `${esc('\x1b[1m')}${s}${R}`;
const dim = (s: string) => `${esc('\x1b[2m')}${s}${R}`;
const italic = (s: string) => `${esc('\x1b[3m')}${s}${R}`;

const fg = (n: number, s: string) => `${esc(`\x1b[38;5;${n}m`)}${s}${R}`;

function visibleLen(s: string): number {
  if (!color) return s.length;
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Sentry: disabled (no DSN) */
export function formatSentryDisabled(): string {
  const pill = fg(103, ' Sentry ');
  return `${dim('◆')} ${pill} ${dim('SENTRY_DSN not set — error tracking disabled')}`;
}

/** Sentry: initialized */
export function formatSentryReady(nodeEnv: string): string {
  const pill = fg(42, ' Sentry ');
  return `${dim('◆')} ${pill} ${dim('Initialized for')} ${bold(nodeEnv)}`;
}

function gradientBar(width: number): string {
  if (!color) return '─'.repeat(width);
  const stops = [45, 51, 49, 43, 220, 214, 208, 203];
  let out = '';
  for (let i = 0; i < width; i++) {
    const c = stops[Math.floor((i / width) * stops.length)] ?? stops[0];
    out += fg(c, '▀');
  }
  return out;
}

const INNER = 54;

function row(inner: string): string {
  const pad = Math.max(0, INNER - visibleLen(inner));
  return `${dim('  ║')} ${inner}${' '.repeat(pad)} ${dim('║')}`;
}

/**
 * Fancy startup panel printed when the HTTP server begins listening.
 */
export function printServerReady(port: number): void {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const url = `http://127.0.0.1:${port}`;
  const barW = INNER + 4;

  const title = `${fg(159, '⚕')}  ${bold(fg(255, 'Medical POS'))} ${dim('·')} ${italic(fg(146, 'Backend API'))}`;
  const urlLine = `${dim('▸')}  ${fg(121, bold(url))}`;
  const envLine = `${dim('▸')}  ${dim('environment  ·  ')}${fg(222, nodeEnv)}`;

  console.log('');
  console.log(dim('  ╔') + gradientBar(barW) + dim('╗'));
  console.log(dim('  ║') + ' '.repeat(barW) + dim('║'));
  console.log(row(`   ${title}`));
  console.log(dim('  ║') + ' '.repeat(barW) + dim('║'));
  console.log(row(`   ${urlLine}`));
  console.log(row(`   ${envLine}`));
  console.log(dim('  ║') + ' '.repeat(barW) + dim('║'));
  console.log(dim('  ╚') + dim('═'.repeat(barW)) + dim('╝'));
  console.log('');
}

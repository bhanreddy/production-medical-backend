import * as Sentry from '@sentry/node';
import { env } from '../config/env';
import { formatSentryDisabled, formatSentryReady } from './consoleStyle';

let initialized = false;

export function initSentry() {
  if (initialized || !env.SENTRY_DSN) {
    if (!env.SENTRY_DSN) {
      console.warn(formatSentryDisabled());
    }
    return;
  }

  initialized = true;
  console.log(formatSentryReady(env.NODE_ENV));
}

// Capture an exception with clinic context
export function captureError(error: Error, context?: { clinicId?: string; userId?: string; route?: string }) {
  if (!initialized) {
    console.error('[Untracked Error]', error.message);
    return;
  }

  Sentry.withScope((scope) => {
    if (context?.clinicId) scope.setTag('clinic_id', context.clinicId);
    if (context?.userId) scope.setUser({ id: context.userId });
    if (context?.route) scope.setTag('route', context.route);
    Sentry.captureException(error);
  });
}

// Sentry Express error handler — place AFTER all routes, BEFORE generic errorHandler
export const sentryErrorHandler = Sentry.setupExpressErrorHandler
  ? Sentry.setupExpressErrorHandler
  : (_app: any) => {}; // no-op fallback for older SDK versions

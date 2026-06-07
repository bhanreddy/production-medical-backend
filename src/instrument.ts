import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  profilesSampleRate: 0.1,

  // Scrub PII from breadcrumbs and events
  beforeSend(event) {
    // Strip auth headers
    if (event.request?.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
    }
    return event;
  },

  beforeBreadcrumb(breadcrumb) {
    // Don't log HTTP breadcrumbs that contain auth tokens
    if (breadcrumb.category === 'http' && breadcrumb.data?.url?.includes('token')) {
      return null;
    }
    return breadcrumb;
  },
});

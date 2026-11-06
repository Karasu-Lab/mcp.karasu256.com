export {};

declare global {
  interface Env {
    APP_ENV: 'local' | 'preview' | 'production';
    AUTH_API_URL: string;
    API_URL: string;
    CDN_URL: string;
    APP_ID: string;
    APP_PRIVATE_KEY?: string;
    INTERNAL_API_SECRET: string;
    MCP_OAUTH_CLIENT_ID?: string;
  }
}

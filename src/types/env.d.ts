export {};

declare global {
  interface Env {
    APP_ENV: 'local' | 'preview' | 'production';
    AUTH_API_URL: string;
    API_URL: string;
    CDN_URL: string;
    APP_ID: string;
    APP_PRIVATE_KEY: string;
    INTERNAL_API_SECRET: string;
    DATABASE_URL: string;
    MCP_OAUTH_CLIENT_ID?: string;
    STORAGE_ENDPOINT: string;
    STORAGE_BUCKET: string;
    STORAGE_ACCESS_KEY_ID: string;
    STORAGE_SECRET_ACCESS_KEY: string;
  }
}

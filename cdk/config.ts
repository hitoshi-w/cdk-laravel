export interface IConfig {
  appKey: string;
  appEnv: string;
  appUrl: string;
  dbPassword: string;
  ACMCertificateArn: string;
}

export function getConfig(): IConfig {
  switch (process.env.APP_ENV) {
    case 'production':
      return {
        appKey: process.env.APP_KEY!,
        appEnv: process.env.APP_ENV!,
        appUrl: process.env.APP_URL!,
        dbPassword: process.env.DB_PASSWORD!,
        ACMCertificateArn: process.env.ACM_CERTIFICATE_ARN!,
      }
    default:
      throw new Error('Oops.')
  }
}
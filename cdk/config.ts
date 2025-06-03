export interface IConfig {
  appKey: string;
  appEnv: string;
  ACMCertificateArn: string;
}

export function getConfig(): IConfig {
  switch (process.env.APP_ENV) {
    case 'production':
      return {
        appKey: process.env.APP_KEY!,
        appEnv: process.env.APP_ENV!,
        ACMCertificateArn: process.env.ACM_CERTIFICATE_ARN!,
      }
    default:
      throw new Error('Oops.')
  }
}
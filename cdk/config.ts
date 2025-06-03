export interface IConfig {
  appKey: string;
  ACMCertificateArn: string;
}

export function getConfig(): IConfig {
  switch (process.env.NODE_ENV) {
    case 'dev':
      return {
        appKey: process.env.APP_KEY!,
        ACMCertificateArn: process.env.ACM_CERTIFICATE_ARN!,
      }
    default:
      throw new Error('Oops.')
  }
}
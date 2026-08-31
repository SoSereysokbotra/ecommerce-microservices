export const emailConfig = () => ({
  emailProvider: process.env.EMAIL_PROVIDER ?? 'console',
});

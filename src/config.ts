import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  twilioAccountSid: required("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: required("TWILIO_AUTH_TOKEN"),
  twilioPhoneNumber: required("TWILIO_PHONE_NUMBER"),
  ownerPhoneNumber: required("OWNER_PHONE_NUMBER"),
  publicBaseUrl: required("PUBLIC_BASE_URL"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  port: Number(process.env.PORT ?? 3000),
};

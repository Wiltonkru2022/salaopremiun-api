import { config } from "../config.js";

type SendEmailParams = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
};

export async function sendResendEmail(params: SendEmailParams) {
  if (!config.resendApiKey) {
    const error = new Error("RESEND_API_KEY nao configurada na VPS.");
    (error as Error & { statusCode?: number }).statusCode = 503;
    throw error;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: params.from || config.trialAlertEmailFrom,
      to: [params.to],
      subject: params.subject,
      html: params.html,
      text: params.text,
    }),
  });

  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new Error(
      `Resend respondeu ${response.status}: ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`,
    );
  }

  return body;
}

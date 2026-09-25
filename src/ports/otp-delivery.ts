export interface OtpDeliveryRequest {
  channel: "sms" | "email";
  destination: string;
  code: string;
  ttlSeconds: number;
}

export interface OtpDeliveryProvider {
  send(request: OtpDeliveryRequest): Promise<void>;
}

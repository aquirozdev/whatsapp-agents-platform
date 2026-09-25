export interface OtpDeliveryPort {
  sendSms(destination: string, message: string): Promise<void>;
  sendEmail(destination: string, subject: string, message: string): Promise<void>;
}

import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  async sendVerificationEmail(email: string): Promise<void> {
    this.logger.log(`Verification email queued for ${email}`);
  }
}

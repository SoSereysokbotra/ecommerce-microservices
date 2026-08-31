import { Logger } from '@nestjs/common';
import * as winston from 'winston';

export const appLogger = new Logger('SaaSPlatform');

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

export const createLogger = (serviceName: string) =>
  winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: { service: serviceName },
    format: logFormat,
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
      }),
      new winston.transports.File({
        filename: `logs/${serviceName}-error.log`,
        level: 'error',
      }),
      new winston.transports.File({
        filename: `logs/${serviceName}-combined.log`,
      }),
    ],
  });

import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { LOCALE_HEADER } from '@libs/common';
import { resolveLocale } from './locale.resolver';

@Injectable()
export class LocaleMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const locale = resolveLocale(req);
    req.locale = locale;
    res.setHeader(LOCALE_HEADER, locale);
    next();
  }
}

import { UserRole } from '../enums/user-role.enum';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  sid?: string;
  iat?: number;
  exp?: number;
}

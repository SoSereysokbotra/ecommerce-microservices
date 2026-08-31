import { UserRole } from '../enums/user-role.enum';

export interface UserType {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  role: UserRole;
  isEmailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

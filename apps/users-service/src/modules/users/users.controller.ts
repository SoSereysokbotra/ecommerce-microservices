import {
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Body,
  UnauthorizedException,
} from '@nestjs/common';
import { Public, USER_ID_HEADER } from '@libs/common';
import { UsersService } from './users.service';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UpdateUserDto } from './dto/update-user.dto';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * The caller's own profile, for a service that needs their name.
   *
   * `@Public()` and keyed on the gateway-set `x-user-id`, which is the
   * pattern `AddressesController` established in M10 and the one M13's
   * reviews-service needs: a review shows an author name, the gateway
   * forwards an id rather than a name, and the browser cannot be trusted to
   * supply one. The route is public **only** in the sense that it carries no
   * JWT of its own — it returns whoever the gateway says is calling, and the
   * gateway deletes any `x-user-id` a caller sends before writing its own.
   * Nothing but the gateway is reachable from outside (HANDOFF §3).
   *
   * Declared before `:id` because Nest matches in declaration order and
   * `me` would otherwise be read as an id.
   */
  @Public()
  @Get('me')
  @ApiHeader({ name: USER_ID_HEADER, description: 'Set by the gateway from the verified JWT.' })
  @ApiOperation({ summary: 'The calling user, identified by the gateway' })
  getMe(@Headers(USER_ID_HEADER) userId: string) {
    if (!userId) {
      throw new UnauthorizedException('No authenticated user');
    }
    return this.usersService.getProfile(userId);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.usersService.getProfile(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateUserDto) {
    return this.usersService.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.usersService.delete(id);
  }
}

import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '@libs/common';
import { AdminController } from '../src/modules/search/admin.controller';
import { OpenSearchClient } from '../src/modules/search/opensearch.client';

describe('AdminController (search-service)', () => {
  let controller: AdminController;
  let opensearch: jest.Mocked<OpenSearchClient>;
  const reflector = new Reflector();

  beforeEach(() => {
    opensearch = {
      recreateIndex: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<OpenSearchClient>;

    controller = new AdminController(opensearch);
  });

  it('has @Roles(UserRole.ADMIN) metadata on controller class and handler', () => {
    const classRoles = reflector.get<UserRole[]>(ROLES_KEY, AdminController);
    expect(classRoles).toContain(UserRole.ADMIN);

    const methodRoles = reflector.get<UserRole[]>(ROLES_KEY, controller.recreateIndex);
    expect(methodRoles).toContain(UserRole.ADMIN);
  });

  it('recreates index and returns instructions', async () => {
    const result = await controller.recreateIndex();
    expect(opensearch.recreateIndex).toHaveBeenCalledTimes(1);
    expect(result.index).toBe('products');
    expect(result.next).toContain('POST /catalog/admin/republish');
  });
});

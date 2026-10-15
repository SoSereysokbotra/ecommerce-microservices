import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '@libs/common';
import { ShipmentsController } from '../src/modules/shipping/shipments.controller';
import { ShipmentsService } from '../src/modules/shipping/shipments.service';
import { ShipmentEntity, ShipmentStatus } from '../src/modules/shipping/shipment.entity';

describe('ShipmentsController (shipping-service RBAC & scoping)', () => {
  let controller: ShipmentsController;
  let service: jest.Mocked<ShipmentsService>;
  const reflector = new Reflector();

  beforeEach(() => {
    service = {
      findByOrder: jest.fn(),
      findByOrderForStaff: jest.fn(),
      dispatch: jest.fn(),
      deliver: jest.fn(),
    } as unknown as jest.Mocked<ShipmentsService>;

    controller = new ShipmentsController(service);
  });

  it('protects dispatch and deliver with @Roles(ADMIN, STAFF)', () => {
    const dispatchRoles = reflector.get<UserRole[]>(ROLES_KEY, controller.dispatch);
    expect(dispatchRoles).toContain(UserRole.ADMIN);
    expect(dispatchRoles).toContain(UserRole.STAFF);

    const deliverRoles = reflector.get<UserRole[]>(ROLES_KEY, controller.deliver);
    expect(deliverRoles).toContain(UserRole.ADMIN);
    expect(deliverRoles).toContain(UserRole.STAFF);
  });

  it('scopes findByOrder to customerId when caller is a customer', async () => {
    const fakeShipment = { id: 's-1', orderId: 'o-1', customerId: 'c-1' } as ShipmentEntity;
    service.findByOrder.mockResolvedValue(fakeShipment);

    const result = await controller.findByOrder('c-1', UserRole.CUSTOMER, 'o-1');
    expect(result).toBe(fakeShipment);
    expect(service.findByOrder).toHaveBeenCalledWith('o-1', 'c-1');
    expect(service.findByOrderForStaff).not.toHaveBeenCalled();
  });

  it('allows staff or admin to view any order shipment without customerId requirement', async () => {
    const fakeShipment = { id: 's-1', orderId: 'o-1', customerId: 'c-999' } as ShipmentEntity;
    service.findByOrderForStaff.mockResolvedValue(fakeShipment);

    const result = await controller.findByOrder('', UserRole.STAFF, 'o-1');
    expect(result).toBe(fakeShipment);
    expect(service.findByOrderForStaff).toHaveBeenCalledWith('o-1');
    expect(service.findByOrder).not.toHaveBeenCalled();
  });

  it('calls service.dispatch on dispatch()', async () => {
    const fakeShipment = { id: 's-1', status: ShipmentStatus.DISPATCHED } as ShipmentEntity;
    service.dispatch.mockResolvedValue(fakeShipment);

    const result = await controller.dispatch('s-1', { carrier: 'FedEx', trackingCode: 'TRK123' });
    expect(result).toBe(fakeShipment);
    expect(service.dispatch).toHaveBeenCalledWith('s-1', {
      carrier: 'FedEx',
      trackingCode: 'TRK123',
    });
  });

  it('calls service.deliver on deliver()', async () => {
    const fakeShipment = { id: 's-1', status: ShipmentStatus.DELIVERED } as ShipmentEntity;
    service.deliver.mockResolvedValue(fakeShipment);

    const result = await controller.deliver('s-1');
    expect(result).toBe(fakeShipment);
    expect(service.deliver).toHaveBeenCalledWith('s-1');
  });
});

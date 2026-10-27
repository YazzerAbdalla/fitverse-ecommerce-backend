import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InventoryService } from '../inventory/inventory.service';
import { CreateReservationRefactored } from './dto/create-reservation.dto';
import { ReservationItem } from './entities/reservation-item.entity';
import { Reservation } from './entities/reservation.entity';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

/**
 * This service creates checkout reservations and their items.
 * It relies on the caller's active transaction so inventory and reservation
 * changes either all succeed or all roll back.
 */
@Injectable()
export class ReservationRefactoredService {
  constructor(
    private readonly inventoryService: InventoryService,
    @InjectRepository(Reservation)
    private readonly reservationRepository: Repository<Reservation>,
  ) {}

  /**
   * Creates a reservation for the requested products during checkout.
   *
   * The caller must provide an active transaction and inventory rows locked by
   * that same transaction. InventoryService validates stock and updates it.
   *
   * @param reservationData - Transaction manager, user, requested quantities, and locked inventory rows.
   * @returns A success message and the saved reservation with its saved items.
   * @throws BadRequestException if the duration or product inputs are invalid.
   * @throws InternalServerErrorException if the caller did not provide an active transaction.
   * @throws ConflictException if any product has insufficient available stock.
   * @throws NotFoundException if a requested product has no inventory row.
   */
  async createReservation(
    reservationData: CreateReservationRefactored,
  ): Promise<{
    message: string;
    data: { message: string; reservation: Reservation };
  }> {
    const {
      productsMap,
      inventoryRows,
      manager,
      orderId,
      reservationDurationInMinutes,
      userId,
    } = reservationData;

    // Keep inventory, reservation, and item writes inside the checkout transaction.
    if (manager.queryRunner?.isTransactionActive !== true) {
      throw new InternalServerErrorException(
        'Reservation creation requires an active transaction',
      );
    }

    // A reservation without requested products cannot reserve meaningful stock.
    if (!productsMap || productsMap.size === 0) {
      throw new BadRequestException('Reservation products must not be empty');
    }

    if (!inventoryRows || inventoryRows.length === 0) {
      throw new BadRequestException('Inventory rows must not be empty');
    }

    const reservationDurationMinutes = reservationDurationInMinutes ?? 15;
    // Internal callers must obey the same minimum duration as DTO callers.
    if (
      !Number.isInteger(reservationDurationMinutes) ||
      reservationDurationMinutes < 5
    ) {
      throw new BadRequestException(
        'Reservation duration must be an integer of at least 5 minutes',
      );
    }

    // Expiry is set from the current time using the configured duration.
    const expiresAt = new Date(
      Date.now() + reservationDurationMinutes * 60 * 1000,
    );

    const reservedInventoryRows =
      await this.inventoryService.reserveManyOnCheckout(
        inventoryRows,
        productsMap,
        manager,
      );

    const reservation = manager.create(Reservation, {
      userId,
      orderId: orderId ?? null,
      expiresAt,
    });
    const savedReservation = await manager.save(reservation);

    const inventoryByProductId = new Map(
      reservedInventoryRows.map((inventoryRow) => [
        inventoryRow.productId,
        inventoryRow,
      ]),
    );
    const reservationItems = Array.from(
      productsMap,
      ([productId, quantity]) => {
        const inventoryRow = inventoryByProductId.get(productId);
        if (!inventoryRow) {
          throw new BadRequestException(
            `Inventory row is missing for product ${productId}`,
          );
        }

        return manager.create(ReservationItem, {
          reservationId: savedReservation.id,
          inventoryId: inventoryRow.id,
          quantity,
          reservation: savedReservation,
          inventory: inventoryRow,
        });
      },
    );
    const savedReservationItems = await manager.save(
      ReservationItem,
      reservationItems,
    );

    return {
      message: 'Reservation created successfully',
      data: {
        message: 'Reservation created successfully',
        reservation: {
          ...savedReservation,
          items: savedReservationItems,
        },
      },
    };
  }

  /**
   *
   * @param orderId
   * @param userId
   * @returns The reservation associated with the given orderId and userId, or null if not found.
   * @throws BadRequestException if the orderId or userId is invalid.
   * @throws InternalServerErrorException if there is an issue querying the database.
   * @throws NotFoundException if no reservation is found for the given orderId and userId.
   */

  async getReservationByOrderId(
    orderId: string,
    userId: string,
  ): Promise<Reservation> {
    // Implementation for fetching a reservation by orderId and userId
    // This function should query the database to find the reservation associated with the given orderId and userId. If found, return the reservation; otherwise, return null.
    if (!orderId || !userId) {
      throw new BadRequestException('Invalid orderId or userId');
    }

    const reservation = await this.reservationRepository.findOne({
      where: { orderId, userId },
      relations: { user: true, items: true, order: true }, // Include related entities if needed
    });

    if (!reservation) {
      throw new NotFoundException(
        `No reservation found for orderId: ${orderId} and userId: ${userId}`,
      );
    }

    return reservation;
  }

  /**
   *
   * This function used in the reservation life cycle service to save the status updates through the service which it the only one responsible to call the repository.
   * @param reservation
   * @returns Promise Reservatoin
   */

  async saveUpdatedReservation(updatedReservation: Reservation) {
    return await this.reservationRepository.save(updatedReservation);
  }
}

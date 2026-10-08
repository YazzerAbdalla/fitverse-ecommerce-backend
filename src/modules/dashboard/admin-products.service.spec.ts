import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import {
  AdminProductsService,
  escapeLikeWildcards,
  mapStockStatus,
} from './admin-products.service';

/**
 * Unit tests for the admin product list math (019 US1, T007).
 * The DataSource/query-builder chain is mocked; these tests prove
 * status derivation, threshold override, missing-row fallback,
 * combined filters, and pagination meta — not SQL strings.
 * Real-SQL proof lives in admin-products.integration.spec.ts (T008).
 */

type MockChain = {
  [method: string]: jest.Mock;
};

/** Builds a chainable query-builder mock with canned terminal results. */
function buildListChain(
  rows: Record<string, unknown>[],
  total: number,
): { listChain: MockChain; countChain: MockChain; repo: object } {
  const chainMethods = [
    'select',
    'addSelect',
    'leftJoin',
    'where',
    'andWhere',
    'setParameters',
    'orderBy',
    'addOrderBy',
    'offset',
    'limit',
  ];
  const makeChain = (): MockChain => {
    const chain: MockChain = {};
    for (const method of chainMethods) {
      chain[method] = jest.fn().mockReturnValue(chain);
    }
    return chain;
  };
  const listChain = makeChain();
  const countChain = makeChain();
  listChain['getRawMany'] = jest.fn().mockResolvedValue(rows);
  listChain['clone'] = jest.fn().mockReturnValue(countChain);
  countChain['getRawOne'] = jest.fn().mockResolvedValue({ count: `${total}` });
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue(listChain),
  };
  return { listChain, countChain, repo };
}

/** Builds the service with a mocked DataSource returning canned rows. */
function buildService(
  rows: Record<string, unknown>[],
  total: number,
): {
  service: AdminProductsService;
  listChain: MockChain;
  countChain: MockChain;
} {
  const { listChain, countChain, repo } = buildListChain(rows, total);
  const dataSource = {
    getRepository: jest.fn().mockReturnValue(repo),
  } as unknown as DataSource;
  return {
    service: new AdminProductsService(dataSource),
    listChain,
    countChain,
  };
}

describe('mapStockStatus', () => {
  it('maps zero available to out-of-stock', () => {
    expect(mapStockStatus(0, 5)).toBe('out-of-stock');
  });

  it('maps within-threshold available to low-stock (boundary inclusive)', () => {
    expect(mapStockStatus(1, 5)).toBe('low-stock');
    expect(mapStockStatus(5, 5)).toBe('low-stock');
  });

  it('maps above-threshold available to in-stock', () => {
    expect(mapStockStatus(6, 5)).toBe('in-stock');
  });

  it('makes low-stock unreachable when threshold is 0', () => {
    expect(mapStockStatus(0, 0)).toBe('out-of-stock');
    expect(mapStockStatus(1, 0)).toBe('in-stock');
  });
});

describe('escapeLikeWildcards', () => {
  it('escapes %, _, and backslash so search cannot inject wildcards', () => {
    expect(escapeLikeWildcards('100%_x\\y')).toBe('100\\%\\_x\\\\y');
  });

  it('leaves plain text untouched', () => {
    expect(escapeLikeWildcards('phone')).toBe('phone');
  });
});

describe('AdminProductsService.listAdminProducts (019 US1)', () => {
  it('derives status per row from available with the default threshold', async () => {
    const { service } = buildService(
      [
        {
          id: 'a',
          name: 'Plenty',
          slug: 'plenty',
          description: 'd',
          price: 10,
          stock: 10,
          reservedAmount: 0,
          available: 10,
        },
        {
          id: 'b',
          name: 'Low',
          slug: 'low',
          description: 'd',
          price: 10,
          stock: 5,
          reservedAmount: 2,
          available: 3,
        },
        {
          id: 'c',
          name: 'Gone',
          slug: 'gone',
          description: 'd',
          price: 10,
          stock: 2,
          reservedAmount: 2,
          available: 0,
        },
      ],
      3,
    );

    const { data } = await service.listAdminProducts({});

    expect(data.map((row) => row.status)).toEqual([
      'in-stock',
      'low-stock',
      'out-of-stock',
    ]);
    expect(data[0]).toMatchObject({ stock: 10, reservedAmount: 0 });
  });

  it('honors the per-request threshold override', async () => {
    const { service } = buildService(
      [
        {
          id: 'b',
          name: 'Low',
          slug: 'low',
          description: 'd',
          price: 10,
          stock: 5,
          reservedAmount: 2,
          available: 3,
        },
      ],
      1,
    );

    const { data } = await service.listAdminProducts({ lowThreshold: 2 });

    expect(data[0]?.status).toBe('in-stock');
  });

  it('lists missing-inventory rows as out-of-stock with zero quantity', async () => {
    const { service } = buildService(
      [
        {
          id: 'o',
          name: 'Orphan',
          slug: 'orphan',
          description: 'd',
          price: 10,
          stock: null,
          reservedAmount: null,
          available: null,
        },
      ],
      1,
    );

    const { data } = await service.listAdminProducts({});

    expect(data[0]).toMatchObject({
      stock: 0,
      reservedAmount: 0,
      available: 0,
      status: 'out-of-stock',
    });
  });

  it('coerces string numerics from the raw query', async () => {
    const { service } = buildService(
      [
        {
          id: 's',
          name: 'Stringy',
          slug: 'stringy',
          description: 'd',
          price: '150',
          stock: '8',
          reservedAmount: '3',
          available: '5',
        },
      ],
      1,
    );

    const { data } = await service.listAdminProducts({});

    expect(data[0]).toMatchObject({
      price: 150,
      stock: 8,
      reservedAmount: 3,
      available: 5,
      status: 'low-stock',
    });
  });

  it('returns the repo pagination envelope with correct meta', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `p${index}`,
      name: `P${index}`,
      slug: `p${index}`,
      description: 'd',
      price: 10,
      stock: 10,
      reservedAmount: 0,
      available: 10,
    }));
    const { service } = buildService(rows, 45);

    const { data, meta } = await service.listAdminProducts({
      page: 2,
      limit: 20,
    });

    expect(data).toHaveLength(5);
    expect(meta).toEqual({
      totalItems: 45,
      itemCount: 5,
      itemsPerPage: 20,
      totalPages: 3,
      currentPage: 2,
    });
  });

  it('returns an empty list with zeroed totals when nothing matches', async () => {
    const { service } = buildService([], 0);

    const { data, meta } = await service.listAdminProducts({
      search: 'no-such-product',
    });

    expect(data).toEqual([]);
    expect(meta.totalItems).toBe(0);
  });

  it('passes the escaped search with wildcards wrapped for ILIKE', async () => {
    const { service, listChain } = buildService([], 0);

    await service.listAdminProducts({ search: '100%_x' });

    const andWhereCalls = listChain['andWhere'];
    const searchCall = andWhereCalls.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('ILIKE'),
    );
    expect(searchCall).toBeDefined();
    expect(searchCall?.[1]).toMatchObject({ search: '%100\\%\\_x%' });
  });

  it('binds the status filter and threshold for SQL-side filtering', async () => {
    const { service, listChain } = buildService([], 0);

    await service.listAdminProducts({ status: 'low-stock', lowThreshold: 5 });

    const andWhereCalls = listChain['andWhere'];
    const statusCall = andWhereCalls.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('statusFilter'),
    );
    expect(statusCall).toBeDefined();
    expect(statusCall?.[1]).toMatchObject({ statusFilter: 'low-stock' });
    // Same threshold value filters SQL and maps the response (D4 mirror).
    expect(listChain['setParameters']).toHaveBeenCalledWith(
      expect.objectContaining({ lowThreshold: 5 }),
    );
  });

  it('rejects minPrice above maxPrice without touching the database', async () => {
    const dataSource = {
      getRepository: jest.fn(),
    } as unknown as DataSource;
    const service = new AdminProductsService(dataSource);

    await expect(
      service.listAdminProducts({ minPrice: 100, maxPrice: 10 }),
    ).rejects.toThrow(BadRequestException);
    expect(dataSource.getRepository).not.toHaveBeenCalled();
  });

  it('references the Product repository (never Inventory directly)', async () => {
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(buildListChain([], 0).repo),
    } as unknown as DataSource;
    const service = new AdminProductsService(dataSource);

    await service.listAdminProducts({});

    expect(dataSource.getRepository).toHaveBeenCalledWith(Product);
    expect(dataSource.getRepository).toHaveBeenCalledTimes(1);
  });
});

import { AppDataSource } from '../../../data-source';
import Logger from '../../../lib/logger';

/**
 * Migration: adds APPSUMO_TIER_1/2/3 to plan_type enums in PostgreSQL.
 * Must run BEFORE deploying the updated entity files, because TypeORM
 * synchronize cannot add values to existing PostgreSQL enums.
 *
 * Covers all three tables that use plan_type enums:
 * - user_subscription
 * - payment_transaction
 * - subscription_transition (both fromPlanType and toPlanType)
 *
 * If the enum type names differ in your database, check with:
 *   SELECT typname FROM pg_type WHERE typname LIKE '%plantype%';
 */
export async function addAppSumoEnums() {
  try {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();

    const enumTypes = [
      'user_subscription_plantype_enum',
      'payment_transaction_plantype_enum',
      'subscription_transition_fromplantype_enum',
      'subscription_transition_toplantype_enum',
    ];

    const tiers = ['APPSUMO_TIER_1', 'APPSUMO_TIER_2', 'APPSUMO_TIER_3'];

    const statements = enumTypes.flatMap((enumType) =>
      tiers.map(
        (tier) => `
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = '${tier}'
          AND enumtypid = (SELECT oid FROM pg_type WHERE typname = '${enumType}')
        ) THEN
          ALTER TYPE ${enumType} ADD VALUE '${tier}';
        END IF;`,
      ),
    );

    await queryRunner.query(`
      DO $$
      BEGIN
        ${statements.join('\n')}
      END
      $$;
    `);

    Logger.info('Successfully added AppSumo enum values to all plan_type enums');
    await queryRunner.release();
    await AppDataSource.destroy();
  } catch (error) {
    Logger.error('Error adding AppSumo enum values:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  addAppSumoEnums();
}

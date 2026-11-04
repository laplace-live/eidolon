import { type LogLevel, logger } from "@eidolon/config";
import { logger as pipedogLogger } from "@pipedog/core/utils/logger";

/** Routes pipedog's logger into @eidolon/config's sinks and sets both levels. */
export function configureLogging(options: { level: LogLevel }): void {
  logger.setLevel(options.level);
  pipedogLogger.setLevel(options.level);
  // pipedog has already masked credentials in WARNING+ records by the time a sink sees them.
  pipedogLogger.setSink((record) => logger.log(record.level, record.message, record.error));
}

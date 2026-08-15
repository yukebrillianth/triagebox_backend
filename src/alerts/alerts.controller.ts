import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Alert, AlertSeverity } from '@prisma/client';
import { AlertsService } from './alerts.service';

@Controller('api/alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list(
    @Query('severity') severity?: string,
    @Query('acked') acked?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ): Promise<Alert[]> {
    if (limit !== undefined && (limit < 1 || limit > 100)) {
      throw new BadRequestException('limit must be between 1 and 100');
    }
    let severityFilter: AlertSeverity | undefined;
    if (severity !== undefined && severity !== '') {
      if (!Object.values(AlertSeverity).includes(severity as AlertSeverity)) {
        throw new BadRequestException(
          `severity must be one of ${Object.values(AlertSeverity).join(', ')}`,
        );
      }
      severityFilter = severity as AlertSeverity;
    }
    let ackedFilter: boolean | undefined;
    if (acked === 'true') ackedFilter = true;
    else if (acked === 'false') ackedFilter = false;
    else if (acked !== undefined && acked !== '') {
      throw new BadRequestException('acked must be true or false');
    }
    return this.alerts.list({
      severity: severityFilter,
      acked: ackedFilter,
      limit,
    });
  }

  @Post(':id/ack')
  @HttpCode(200)
  ack(@Param('id') id: string): Promise<Alert> {
    return this.alerts.ack(id);
  }
}

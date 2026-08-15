import { Controller, Get } from '@nestjs/common';
import { AnalyticsSummary, SystemService } from './system.service';

@Controller('api/analytics')
export class AnalyticsController {
  constructor(private readonly system: SystemService) {}

  @Get('summary')
  summary(): Promise<AnalyticsSummary> {
    return this.system.getAnalyticsSummary();
  }
}

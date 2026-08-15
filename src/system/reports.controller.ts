import { Controller, Get } from '@nestjs/common';
import { ReportsSummary, SystemService } from './system.service';

@Controller('api/reports')
export class ReportsController {
  constructor(private readonly system: SystemService) {}

  @Get('summary')
  summary(): Promise<ReportsSummary> {
    return this.system.getReportsSummary();
  }
}

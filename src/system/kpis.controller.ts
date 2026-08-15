import { Controller, Get } from '@nestjs/common';
import { KpiResponse, SystemService } from './system.service';

@Controller('api/kpis')
export class KpisController {
  constructor(private readonly system: SystemService) {}

  @Get()
  getKpis(): Promise<KpiResponse> {
    return this.system.getKpis();
  }
}

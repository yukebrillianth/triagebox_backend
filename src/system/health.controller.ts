import { Controller, Get } from '@nestjs/common';
import { HealthResponse, SystemService } from './system.service';

@Controller('api/health')
export class HealthController {
  constructor(private readonly system: SystemService) {}

  @Get()
  health(): Promise<HealthResponse> {
    return this.system.getHealth();
  }
}

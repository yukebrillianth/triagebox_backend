import { Body, Controller, Get, Put } from '@nestjs/common';
import { SettingsResponse, SystemService } from './system.service';

@Controller('api/settings')
export class SettingsController {
  constructor(private readonly system: SystemService) {}

  @Get()
  getSettings(): Promise<SettingsResponse> {
    return this.system.getSettingsWithTiming();
  }

  // ponytail: free-form key-value (hospital_name, disaster_name, operator + any string key)
  @Put()
  putSettings(
    @Body() body: Record<string, unknown>,
  ): Promise<SettingsResponse> {
    return this.system.putSettings(body);
  }
}

import { Body, Controller, Get, Put } from '@nestjs/common';
import { SystemService } from './system.service';

@Controller('api/settings')
export class SettingsController {
  constructor(private readonly system: SystemService) {}

  @Get()
  getSettings(): Promise<Record<string, string>> {
    return this.system.getSettings();
  }

  // ponytail: free-form key-value (hospital_name, disaster_name, operator + any string key)
  @Put()
  putSettings(
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    return this.system.putSettings(body);
  }
}

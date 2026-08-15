import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { Priority, TriageHistory, Victim, VitalReading } from '@prisma/client';
import { UpdateVictimDto } from './dto/update-victim.dto';
import { VictimsService } from './victims.service';

@Controller('api/victims')
export class VictimsController {
  constructor(private readonly victimsService: VictimsService) {}

  @Get()
  findAll(
    @Query('search') search?: string,
    @Query('priority') priority?: Priority,
    @Query('nodeId') nodeId?: string,
    @Query('sort') sort?: 'lastUpdate_desc' | 'lastUpdate_asc' | 'rfid',
  ): Promise<Victim[]> {
    return this.victimsService.findAll({ search, priority, nodeId, sort });
  }

  @Get(':id/vitals')
  findVitals(
    @Param('id') id: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ): Promise<VitalReading[]> {
    return this.victimsService.findVitals(id, limit);
  }

  @Get(':id/triage-history')
  findTriageHistory(@Param('id') id: string): Promise<TriageHistory[]> {
    return this.victimsService.findTriageHistory(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Victim> {
    return this.victimsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateVictimDto,
  ): Promise<Victim> {
    return this.victimsService.update(id, dto);
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  Priority,
  TriageHistory,
  VictimStatus,
  VitalReading,
} from '@prisma/client';
import { OverrideVictimDto } from './dto/override-victim.dto';
import { UpdateVictimDto } from './dto/update-victim.dto';
import { VictimView } from './victim-view';
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
    @Query('status') status?: VictimStatus,
  ): Promise<VictimView[]> {
    if (status !== undefined && !(status in VictimStatus)) {
      throw new BadRequestException(
        `status must be one of ${Object.values(VictimStatus).join(', ')}`,
      );
    }
    return this.victimsService.findAll({ search, priority, nodeId, sort, status });
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
  findOne(@Param('id') id: string): Promise<VictimView> {
    return this.victimsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateVictimDto,
  ): Promise<VictimView> {
    return this.victimsService.update(id, dto);
  }

  @Post(':id/override')
  override(
    @Param('id') id: string,
    @Body() dto: OverrideVictimDto,
  ): Promise<VictimView> {
    return this.victimsService.override(id, dto);
  }
}

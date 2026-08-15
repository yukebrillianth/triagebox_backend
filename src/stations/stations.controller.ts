import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CreateStationDto } from './dto/create-station.dto';
import { UpdateStationDto } from './dto/update-station.dto';
import { StationsService, StationWithNodeCount } from './stations.service';

@Controller('api/stations')
export class StationsController {
  constructor(private readonly stations: StationsService) {}

  @Get()
  findAll(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<StationWithNodeCount[]> {
    return this.stations.findAll(includeInactive === 'true');
  }

  @Post()
  create(@Body() dto: CreateStationDto): Promise<StationWithNodeCount> {
    return this.stations.create(dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<StationWithNodeCount> {
    return this.stations.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStationDto,
  ): Promise<StationWithNodeCount> {
    return this.stations.update(id, dto);
  }

  @Delete(':id')
  softDelete(@Param('id') id: string): Promise<StationWithNodeCount> {
    return this.stations.softDelete(id);
  }
}

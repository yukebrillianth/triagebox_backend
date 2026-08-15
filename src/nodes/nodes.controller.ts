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
import { DeviceStatus } from '@prisma/client';
import { CreateNodeDto } from './dto/create-node.dto';
import { UpdateNodeDto } from './dto/update-node.dto';
import { NodeResponse, NodesService } from './nodes.service';

@Controller('api/nodes')
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Get()
  findAll(
    @Query('stationId') stationId?: string,
    @Query('status') status?: DeviceStatus,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<NodeResponse[]> {
    return this.nodes.findAll({
      stationId,
      status,
      includeInactive: includeInactive === 'true',
    });
  }

  @Post()
  create(@Body() dto: CreateNodeDto): Promise<NodeResponse> {
    return this.nodes.create(dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<NodeResponse> {
    return this.nodes.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateNodeDto,
  ): Promise<NodeResponse> {
    return this.nodes.update(id, dto);
  }

  @Delete(':id')
  softDelete(@Param('id') id: string): Promise<NodeResponse> {
    return this.nodes.softDelete(id);
  }
}

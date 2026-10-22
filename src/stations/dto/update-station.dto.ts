import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateStationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  firmware?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ipAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  mqttBrokerHost?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  mqttBrokerPort?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  postName?: string;

  /** Village / sub-district, free text. No coordinates in this system. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  locationLabel?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  nodeCapacity?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3600)
  pollPeriodSec?: number;
}

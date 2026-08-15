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
}

import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateNodeDto {
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
  @MinLength(1)
  @MaxLength(64)
  stationId?: string;
}

import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateNodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  stationId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  firmware?: string;
}

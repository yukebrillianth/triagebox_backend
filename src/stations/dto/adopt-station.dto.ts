import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class AdoptStationDto {
  /** Identity of the pending candidate. Not editable -- it is the board's MAC. */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  mac!: string;

  /** Station id to register. Defaults in the UI to the announced one. */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  /** Falls back to the announced node_count when omitted. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(255)
  nodeCount?: number;

  /**
   * Offset for the generated node ids, so a second station gets node-21.. rather
   * than colliding on node-01. Node ids are unique across stations in the
   * database, but each station's radio addresses always start at 1.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(255)
  nodeIdBase?: number;
}

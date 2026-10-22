import { Priority } from '@prisma/client';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';

/** An operator's category decision. The reason is mandatory: it is the audit. */
export class OverrideVictimDto {
  @IsEnum(Priority)
  priority!: Priority;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  reason!: string;
}

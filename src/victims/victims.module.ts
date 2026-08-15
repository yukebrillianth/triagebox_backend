import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { VictimsController } from './victims.controller';
import { VictimsService } from './victims.service';

@Module({
  imports: [ActivityModule],
  controllers: [VictimsController],
  providers: [VictimsService],
  exports: [VictimsService],
})
export class VictimsModule {}

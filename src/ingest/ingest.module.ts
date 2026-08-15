import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { NodesModule } from '../nodes/nodes.module';
import { VictimsModule } from '../victims/victims.module';
import { IngestService } from './ingest.service';

@Module({
  imports: [NodesModule, VictimsModule, ActivityModule],
  providers: [IngestService],
  exports: [IngestService],
})
export class IngestModule {}

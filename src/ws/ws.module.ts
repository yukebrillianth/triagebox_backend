import { Module } from '@nestjs/common';
import { VictimsModule } from '../victims/victims.module';
import { EventsGateway } from './events.gateway';

@Module({
  imports: [VictimsModule],
  providers: [EventsGateway],
})
export class WsModule {}

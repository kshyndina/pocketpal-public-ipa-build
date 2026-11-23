#import <React/RCTBridgeModule.h>
#import <AVFoundation/AVFoundation.h>

@interface BlueSpeech : NSObject <RCTBridgeModule, AVAudioPlayerDelegate>
@property (nonatomic, strong) NSURLSessionDataTask *task;
@property (nonatomic, strong) AVAudioPlayer *player;
@property (nonatomic, copy) RCTPromiseResolveBlock resolve;
@property (nonatomic, copy) RCTPromiseRejectBlock reject;
@property (nonatomic) NSUInteger generation;
@end

@implementation BlueSpeech
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }

- (void)finishWithError:(NSString *)message {
  if (self.reject) self.reject(@"BLUE_TTS", message, nil);
  self.reject = nil;
  self.resolve = nil;
}
- (void)cancelCurrent {
  self.generation++;
  [self.task cancel]; self.task = nil;
  [self.player stop]; self.player = nil;
  // Stopping or replacing playback is expected, not a server/playback failure.
  // Settle the previous play promise without surfacing a stale error in the picker.
  RCTPromiseResolveBlock previousResolve = self.resolve;
  self.resolve = nil;
  self.reject = nil;
  if (previousResolve) previousResolve(nil);
}
RCT_REMAP_METHOD(stop, stopWithResolve:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{ [self cancelCurrent]; resolve(nil); });
}
RCT_REMAP_METHOD(play, playAtURL:(NSString *)base text:(NSString *)text voice:(NSString *)voice resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self cancelCurrent];
    NSURLComponents *components = [NSURLComponents componentsWithString:base];
    if (!components.host.length || !([components.scheme isEqualToString:@"https"] || [components.scheme isEqualToString:@"http"]) || components.user || components.password || components.query || components.fragment) {
      reject(@"BLUE_URL", @"Invalid BlueTTS server URL.", nil); return;
    }
    self.resolve = resolve; self.reject = reject;
    NSUInteger requestGeneration = self.generation;
    NSString *path = components.path ?: @"";
    components.path = [path stringByAppendingString:@"/v1/audio/speech"];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:components.URL];
    request.HTTPMethod = @"POST";
    request.timeoutInterval = 90;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    [request setValue:@"audio/wav" forHTTPHeaderField:@"Accept"];
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{@"model": @"bluev3", @"input": text, @"voice": voice, @"response_format": @"wav"} options:0 error:nil];
    self.task = [[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (requestGeneration != self.generation) return;
        self.task = nil;
        if (error) { [self finishWithError:[NSString stringWithFormat:@"BlueTTS connection failed: %@", error.localizedDescription]]; return; }
        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        if (status < 200 || status >= 300) { [self finishWithError:[NSString stringWithFormat:@"BlueTTS server returned HTTP %ld. Check the URL and server logs.", (long)status]]; return; }
        if (data.length < 44 || data.length > 25 * 1024 * 1024 || ![[[NSString alloc] initWithData:[data subdataWithRange:NSMakeRange(0, 4)] encoding:NSASCIIStringEncoding] isEqualToString:@"RIFF"]) {
          [self finishWithError:@"BlueTTS returned invalid or oversized WAV audio (maximum 25 MB)."];
          return;
        }
        NSError *audioError = nil;
        [[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryPlayback error:&audioError];
        if (!audioError) [[AVAudioSession sharedInstance] setActive:YES error:&audioError];
        if (audioError) { [self finishWithError:audioError.localizedDescription]; return; }
        self.player = [[AVAudioPlayer alloc] initWithData:data error:&audioError];
        self.player.delegate = self;
        if (audioError || ![self.player play]) { [self finishWithError:audioError.localizedDescription ?: @"Cannot play BlueTTS audio."]; return; }
      });
    }];
    [self.task resume];
  });
}
- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player successfully:(BOOL)flag {
  if (player != self.player) return;
  self.player = nil;
  if (flag) { if (self.resolve) self.resolve(nil); self.resolve = nil; self.reject = nil; }
  else [self finishWithError:@"BlueTTS audio playback failed."];
}
@end

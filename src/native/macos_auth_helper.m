#import <Foundation/Foundation.h>
#import <OpenDirectory/OpenDirectory.h>

static NSString *readPasswordFromStdin(void) {
  NSFileHandle *stdinHandle = [NSFileHandle fileHandleWithStandardInput];
  NSData *data = [stdinHandle readDataToEndOfFile];
  if (data == nil || data.length == 0) {
    return nil;
  }

  NSString *password = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (password == nil) {
    return nil;
  }

  return [password stringByTrimmingCharactersInSet:[NSCharacterSet newlineCharacterSet]];
}

static BOOL verifyPasswordOnNode(ODSession *session, NSString *nodeName, NSString *username, NSString *password) {
  NSError *error = nil;
  ODNode *node = [ODNode nodeWithSession:session name:nodeName error:&error];
  if (node == nil) {
    return NO;
  }

  ODRecord *record = [node recordWithRecordType:kODRecordTypeUsers name:username attributes:nil error:&error];
  if (record == nil) {
    return NO;
  }

  return [record verifyPassword:password error:&error];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      return 12;
    }

    NSString *username = [NSString stringWithUTF8String:argv[1]];
    if (username == nil || username.length == 0) {
      return 10;
    }

    NSString *password = readPasswordFromStdin();
    if (password == nil) {
      return 12;
    }

    ODSession *session = [ODSession defaultSession];
    if (session == nil) {
      return 11;
    }

    NSArray<NSString *> *nodeNames = @[ @"/Search", @"/Local/Default" ];
    for (NSString *nodeName in nodeNames) {
      if (verifyPasswordOnNode(session, nodeName, username, password)) {
        return 0;
      }
    }

    return 10;
  }
}

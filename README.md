# Agent Board

Cursor·VS Code 안에서 에이전트 작업을 카드 단위로 관리하는 칸반 확장 프로그램입니다. 카드마다 작업 명세(`intent.md`·`spec.md`·`plan.md`), 진행률, 에이전트 실행 이력, 코드 리뷰 결과를 함께 관리합니다. Claude Code·Codex·Cursor CLI를 구현자와 리뷰어로 지정해 실행할 수 있습니다.

- 기획: [intent.md](intent.md)
- 요구사항: [spec.md](spec.md)
- 구현 계획: [plan.md](plan.md)
- 에이전트 CLI 조사 결과: [docs/agent-cli.md](docs/agent-cli.md)

## 사용법

1. 명령 팔레트에서 **Agent Board: 보드 열기**를 실행하고 **이 레포에 보드 만들기**를 누릅니다.
2. Todo 열의 `+ 새 카드`로 카드를 만듭니다. 카드마다 `.agent-board/tasks/<작업 ID>/` 아래에 작업 문서 3종이 생깁니다.
3. 카드를 클릭해 상세 화면을 엽니다. **개요** 탭에서 구현자·리뷰어 에이전트를 지정하고, **Plan** 탭에서 체크리스트를 작성합니다.
4. **실행 이력** 탭에서 에이전트를 실행·재개·중단하거나 리뷰를 요청합니다. 실행하면 카드 전용 worktree(`../<레포>-worktrees/<작업 ID>`, 브랜치 `task/<작업 ID>`)가 만들어집니다.
5. 카드는 자동으로 옮겨집니다.
   - 구현자가 작업을 시작하면 In Progress로 갑니다. 보드에서 실행한 경우와 채팅 세션 모두 해당합니다.
   - 응답이 끝났을 때 체크리스트가 모두 완료돼 있으면 Review로 갑니다.
   - 리뷰가 통과하면 Done으로 갑니다. 리뷰어가 없는 카드는 Review에서 멈추니 직접 Done으로 옮기세요.
   - 작업 중에 카드를 손으로 옮기면 그 요청이 끝날 때는 자동으로 옮기지 않습니다.

   **자동 수정·재리뷰**를 켜면 리뷰 지적 사항을 구현자에게 넘기고 다시 리뷰합니다(기본 최대 3회).

**카드 문서**: 카드를 누르면 전체 화면 카드 화면이 열리고, 모든 카드가 canvas 스타일 문서로 보입니다. 글은 intent·spec·plan(Markdown)이고, 다이어그램·차트는 카드 폴더의 `canvas.tsx`에 컴포넌트로 두고 md에 ```` ```canvas 이름 ```` 블록으로 넣습니다. 문서는 워드처럼 글을 눌러 바로 고치고(Enter는 새 문단·새 항목), 그림 안의 글자는 두 번 눌러 고칩니다. 고친 글에서 벗어나면 원문 파일의 해당 줄만 저장됩니다. **코드 편집**은 그림 코드를 보드 옆 칸에 엽니다. 칸반 아래의 공용 문서 표는 문서·일자(마지막 커밋일)·브랜치·구분을 보여 주고, `.canvas.tsx`·`.md` 문서는 보드 안에서 같은 스타일로 열립니다. 구분은 문서 행의 `⋯`에서 지정합니다. API 명세서처럼 같은 구조가 반복되는 참조 문서는 페이지 전체를 컴포넌트로 쓴 `.canvas.tsx`입니다([docs/api.canvas.tsx](docs/api.canvas.tsx), 접점마다 Request/Response). 그림 코드는 Cursor canvas와 같은 형식(`import … from "cursor/canvas"`)이라 Cursor·Claude Code·Codex 어느 에이전트든 쓸 수 있습니다. **에이전트에게 그림 요청**을 누르면 에이전트가 [docs/canvas-guide.md](docs/canvas-guide.md)를 읽고 그림을 넣습니다.

**구분과 일정**: plan.md 절 제목을 `## [BE] 로그인 API`처럼 쓰면 그 아래 항목이 BE로 집계되어 보드 위쪽의 구분별 진척과 카드 태그에 나타납니다. 구분은 설정 화면에서 추가합니다. 카드 상세의 개요 탭에서 시작일·마감일·선행 카드를 지정하면, 마감일을 넘긴 카드에 D+N이 표시됩니다.

**에이전트 채팅으로 카드 만들기**: **에이전트 세션 Hook 설치**를 한 번 실행해 두면, 레포에서 Cursor·Claude Code·Codex 채팅에 보낸 첫 요청이 보드에 반영됩니다. 기존 카드에 속하는 요청이면 그 카드의 intent·spec·plan에 더해지고, 아니면 Todo에 새 카드가 생깁니다. 어느 쪽이든 에이전트에게 카드 ID와 작업 문서 경로가 전달됩니다. 판단에는 설치된 CLI(기본 Claude Code haiku)를 짧게 호출하므로 모델 사용량이 조금 듭니다.

**세션 열기**: 카드의 에이전트 칩(claude·codex·cursor)을 누르면 그 세션이 열립니다. 채팅에서 시작한 세션은 이 창의 Claude Code·Codex·Cursor 채팅 화면에서, 보드가 실행한 세션은 카드 worktree 터미널에서 이어 열립니다.

키보드: 카드에 포커스를 두고 `Alt+←/→`로 열을 옮기고, `Alt+↑/↓`로 순서를 바꾸고, `Enter`로 상세 화면을 엽니다.

## 명령

| 명령 | 설명 |
| --- | --- |
| Agent Board: 보드 열기 | 보드를 엽니다 |
| Agent Board: 카드 만들기 | 제목을 입력해 Todo에 카드를 만듭니다 |
| Agent Board: 카드 ID 변경 | 병합 후 ID가 겹친 카드에 새 ID를 줍니다 |
| Agent Board: 에이전트 세션 Hook 설치 | 도구에서 직접 시작한 세션도 카드에 반영되도록 Hook을 설치합니다 |
| Agent Board: 에이전트 CLI 다시 찾기 | 설치된 CLI와 버전을 다시 확인합니다 |
| Agent Board: 설정 열기 | 구분, 연결할 도구, 리뷰·실행 옵션, 카드 자동 생성을 한곳에서 설정합니다 |

## 설정

보드 상단의 **설정** 버튼에서 모든 설정을 바꿀 수 있습니다. "팀 공유" 항목(구분, 이 보드에서 쓸 도구, 리뷰·실행 옵션)은 `board.json`에 저장되어 Git으로 공유되고, "이 기기" 항목은 아래 VS Code 사용자 설정에 저장됩니다.

| 설정 | 설명 |
| --- | --- |
| `agentBoard.toolPaths` | PATH에서 찾지 못하는 CLI 경로. 예: `{ "claude": "/opt/claude/bin/claude" }` |
| `agentBoard.autoCreateCards` | 연결되지 않은 세션의 첫 요청으로 카드를 만들거나 갱신합니다. 기본 `true` |
| `agentBoard.matcherTool` | 요청이 어느 카드에 속하는지 판단할 CLI. `auto`(Claude Code → Codex → Cursor), 도구 이름, `none`(키워드 비교만) |

카드의 `card.json`에서 에이전트별 옵션을 지정할 수 있습니다.

| 도구 | 옵션 | 기본값 |
| --- | --- | --- |
| 공통 | `model` | 도구 기본값 |
| Claude Code | `permissionMode` (구현자) | `acceptEdits` |
| Codex | `sandbox` (구현자) | `workspace-write` |
| Cursor | `force` (`"true"`면 `--force`) | 사용 안 함 |

## Jira 티켓 발급

카드로 Jira 티켓을 만들 수 있습니다.

1. **설정 → Jira**에서 사이트(예: `example.atlassian.net`)와 프로젝트 키(예: `FDE`)를 지정합니다. 이 값은 `board.json`에 저장되어 팀과 공유됩니다.
2. **계정 연결**을 눌러 Atlassian 이메일과 [API 토큰](https://id.atlassian.com/manage-profile/security/api-tokens)을 입력합니다. Jira에 로그인되는지 확인한 뒤 이 기기의 VS Code 비밀 저장소에만 저장합니다.
3. 카드 문서(intent.md·spec.md)를 확인하고 카드 **개요** 또는 **Jira** 탭에서 **이 카드 승인**을 누릅니다. 승인한 카드만 티켓으로 발급할 수 있습니다. 승인은 그 순간의 intent.md·spec.md 내용 해시로 `card.json`에 남고, 그 뒤 문서가 바뀌면(에이전트가 고친 경우 포함) 다시 승인해야 합니다. 초안을 만들 때와 등록 직전에 모두 확인합니다.
4. 카드의 **Jira** 탭에서 **이 카드로 티켓 초안 만들기**를 누릅니다. 초안은 카드 문서로 채워집니다.
   - 제목: `[서비스] 할 일`. 카드 제목이 `[서비스] …`로 시작하면 서비스로 씁니다. 최근 티켓 제목에 쓰인 서비스명을 추천합니다.
   - 배경·목적 ← intent.md의 목적·배경
   - 할 일 ← spec.md의 요구사항 (없으면 intent.md의 범위)
   - 완료 기준 ← spec.md의 완료 조건. "마케터 리뷰가 필요한 작업"·"배포가 필요한 작업"을 고르면 승인·배포 조건을 덧붙입니다.
5. 업무 유형과, 그 유형에 Jira가 필수로 요구하는 선택 필드(예: 업무 구분)를 고릅니다. 필드와 선택값은 Jira 생성 메타데이터에서 읽습니다.
6. 아래 미리보기가 Jira에 들어갈 내용입니다. 형식 검사에서 오류가 없으면 **이 내용대로 등록**을 누릅니다. 만든 티켓 키는 카드에 저장되고 카드 앞면에 표시됩니다.

형식 검사는 다음을 확인합니다.

- 오류(등록 불가): 유형·필수 선택 필드·서비스명·할 일 제목·배경·목적·할 일·완료 기준이 비어 있음, 키나 토큰으로 보이는 글
- 경고: "개발 완료"·"정상 동작" 같은 완료 기준, "미정"·"TBD", 기대 결과와 실제 결과가 없는 버그

같은 서비스에 제목이 비슷한 티켓이 있으면 후보로 보여 줍니다. 같은 일이면 **이 티켓에 연결**로 기존 티켓을 카드에 연결하세요. 담당자는 Jira 자동화에 맡기므로 보내지 않습니다. Jira가 응답하지 않으면 다시 만들지 않고, 최근 30분 안에 내가 만든 같은 제목의 티켓을 찾아 연결합니다. 찾지 못하면 Jira에서 직접 확인하라고 알립니다.

## 저장 구조

| 경로 | 내용 | Git |
| --- | --- | --- |
| `.agent-board/board.json` | 공용 문서 목록, 보드 설정 | 공유 |
| `.agent-board/tasks/<ID>/card.json` | 카드 메타데이터 (승인 기록, 연결한 Jira 티켓 키 포함) | 공유 |
| `.agent-board/tasks/<ID>/{intent,spec,plan}.md` | 작업 문서 | 공유 |
| `.agent-board/deleted/<ID>` | 삭제된 ID 기록 (재사용 방지) | 공유 |
| `.agent-board/local/` | 실행 기록, 이벤트 로그, 세션 연결, Hook inbox | 제외 |

## Hook

**에이전트 세션 Hook 설치**를 실행하면 레포 루트와 각 카드 worktree에 아래 파일을 만들거나 기존 설정에 항목을 추가합니다. 기존 항목은 유지하고, 이 확장 프로그램이 넣은 항목(`AGENT_BOARD_HOOK=1`)만 교체합니다.

- Claude Code: `.claude/settings.local.json`
- Codex: `.codex/hooks.json` (Codex에서 프로젝트 Hook 신뢰가 필요합니다)
- Cursor: `.cursor/hooks.json`

Hook 스크립트는 이벤트를 `.agent-board/local/inbox/`에 파일로 남깁니다. 네트워크를 쓰지 않으며, 확장 프로그램이 꺼져 있을 때 받은 이벤트도 다음에 열 때 반영합니다. Hook 명령에는 이 기기의 절대 경로가 들어가므로 `.codex/hooks.json`·`.cursor/hooks.json`을 커밋하지 않도록 주의하세요.

## 개발

Cursor나 VS Code에서 이 폴더를 열고 `F5`(**Run Extension**)를 누르면 빌드 감시가 시작되고, 확장 프로그램이 적용된 새 창이 열립니다. 새 창에서 보드를 사용할 레포 폴더를 연 뒤 명령 팔레트에서 **Agent Board: 보드 열기**를 실행합니다. 코드를 고치면 자동으로 다시 빌드되며, 새 창에서 **Developer: Reload Window**를 실행하면 반영됩니다.

```sh
npm install
npm run build            # dist/에 확장 프로그램·웹뷰·Hook 스크립트 빌드
npm run watch            # 변경 감시 빌드 (F5가 자동으로 실행)
npm test                 # 단위 테스트 (가짜 에이전트 CLI로 실행 흐름 포함)
npm run test:integration # VS Code를 내려받아 확장 프로그램 활성화 확인
AGENT_BOARD_SMOKE=claude,codex npm run test:smoke  # 실제 CLI 실행 (모델 사용량 발생)
AGENT_BOARD_SMOKE=classify,autolink npm run test:smoke  # 실제 CLI로 카드 판단·자동 연결 확인
npm run package          # VSIX 생성
```

## 알려진 제한

- Cursor CLI는 문서 기준으로 연동했으며 실제 실행으로 검증하지 않았습니다. 읽기 전용 리뷰와 세션 목록은 지원하지 않습니다.
- Hook 명령은 macOS·Linux 셸 문법으로 작성됩니다. Windows는 확인하지 않았습니다.
- 팀 실시간 동기화는 범위 밖입니다. 카드 정보는 Git으로 공유합니다.
